//! Feature 3: payees paid into their near.com balance (NEAR Intents, research 19).
//!
//! The payout is `ft_transfer_call` to the Intents contract with `msg` = the payee's account id
//! and nothing else: Intents then keeps all of it or refunds all of it (no actions, so nothing
//! like the Oct 2026 refund exploit, which needed a notify action). The payment counts as paid
//! only when the token reports the full amount was kept (`ft_resolve_transfer`'s answer), never
//! from anything Intents says. A refund (wrong id, Intents paused) fails the payment cleanly and
//! the money stays in the budget. Withdrawing from near.com is the payee's own step.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, Gas, NearToken, Promise, PromiseError, near};

use crate::changes::payee_key;
use crate::events::Event;
use crate::request::RequestStatus;
use crate::{Contract, ContractExt, EnvelopeId};

/// Given to the token's `ft_transfer_call`; it keeps 5 Tgas for its resolve step and passes the
/// rest to Intents' `ft_on_transfer`, which uses about 3–5 Tgas for a plain deposit. Measured in
/// the sandbox with the mainnet Intents code (`intents_payout`).
pub(crate) const GAS_INTENTS_DEPOSIT: Gas = Gas::from_tgas(40);
pub(crate) const GAS_ON_INTENTS_PAID: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near]
impl Contract {
    /// The budget's payees who are paid into their near.com balance.
    pub fn list_intents_payees(&self, envelope_id: U64) -> Vec<AccountId> {
        let Some(envelope) = self.envelopes.get(&envelope_id.0) else {
            return vec![];
        };
        envelope
            .payees
            .iter()
            .filter(|p| self.is_intents_payee(envelope_id.0, p))
            .cloned()
            .collect()
    }

    /// Whether this request pays (or paid) into the payee's near.com balance.
    pub fn is_intents_request(&self, request_id: String) -> bool {
        self.intents_requests.contains(&request_id)
    }

    /// Result of a budget payout into near.com. Paid only if the token kept the full amount.
    #[private]
    pub fn on_paid_intents(
        &mut self,
        request_id: String,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> RequestStatus {
        let request = self.requests.get(&request_id).cloned().unwrap();
        let amount = request.amount.0;
        // An error means `ft_transfer_call` itself failed, so nothing moved.
        let used = used.map_or(0, |u| u.0.min(amount));
        let envelope = self.envelopes.get_mut(&request.envelope_id.0).unwrap();
        envelope.in_flight -= amount;
        envelope.balance -= used;
        envelope.spent_total += used;
        if used == amount {
            let (payee, amount) = (request.payee.clone(), request.amount);
            self.settle_paid(&request_id, request);
            self.emit_paid_to_intents(&request_id, &payee, amount);
            RequestStatus::Paid
        } else {
            // `partial_credit` can't happen with a plain account id; if it ever does, the books
            // count what left and the rest stays in the budget.
            let reason = if used == 0 {
                "intents_refused"
            } else {
                "partial_credit"
            };
            self.settle_failed(&request_id, request, reason);
            RequestStatus::Failed
        }
    }

    /// Result of paying the DAO's money into near.com (R22 path). Like `on_dao_payout`: a refund
    /// puts the request back to `dao_funded` so `settle_escalation` can retry.
    #[private]
    pub fn on_dao_payout_intents(
        &mut self,
        request_id: String,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> RequestStatus {
        let request = self.requests.get(&request_id).cloned().unwrap();
        if request.status != RequestStatus::Paying {
            return request.status;
        }
        let amount = request.amount.0;
        let used = used.map_or(0, |u| u.0.min(amount));
        if used == amount {
            let (payee, amount) = (request.payee.clone(), request.amount);
            let status = self.finish_dao_payout(&request_id, request, true);
            self.emit_paid_to_intents(&request_id, &payee, amount);
            return status;
        }
        if used == 0 {
            return self.finish_dao_payout(&request_id, request, false);
        }
        // Can't happen in plain mode. The DAO's leftover joins the budget, so the books stay
        // exact and closing the budget returns it to the DAO.
        let envelope = self.envelopes.get_mut(&request.envelope_id.0).unwrap();
        envelope.balance += amount - used;
        self.settle_failed(&request_id, request, "partial_credit");
        RequestStatus::Failed
    }
}

impl Contract {
    pub(crate) fn is_intents_payee(&self, envelope_id: EnvelopeId, payee: &AccountId) -> bool {
        self.intents_payees.contains(&payee_key(envelope_id, payee))
    }

    /// Sends `amount` into `payee`'s near.com balance. The caller adds the callback.
    pub(crate) fn deposit_to_intents(
        &self,
        token_id: &AccountId,
        payee: &AccountId,
        amount: U128,
        memo: String,
    ) -> Promise {
        // Set when the payee was added, and never cleared.
        let intents = self.intents_contract.clone().unwrap();
        ext_ft_core::ext(token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_INTENTS_DEPOSIT)
            .ft_transfer_call(intents, amount, Some(memo), payee.to_string())
    }

    fn emit_paid_to_intents(&self, request_id: &str, payee: &AccountId, amount: U128) {
        Event::PaidToIntents {
            request_id,
            payee,
            amount,
            intents_contract: self.intents_contract.as_ref().unwrap(),
        }
        .emit();
    }

    /// Gas this call must still have to start a payout to `request_id`'s payee and finish.
    pub(crate) fn payout_gas(&self, request_id: &str) -> Gas {
        if self.intents_requests.contains(request_id) {
            GAS_INTENTS_DEPOSIT.saturating_add(GAS_ON_INTENTS_PAID)
        } else {
            crate::spend::GAS_PAYOUT
        }
    }
}
