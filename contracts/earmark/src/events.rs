use near_sdk::json_types::U64;
use near_sdk::{AccountId, near};

/// NEP-297 events, standard `earmark`.
#[near(event_json(standard = "earmark"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    EnvelopeCreated {
        envelope_id: U64,
        name: &'a str,
        token_id: &'a AccountId,
    },
}
