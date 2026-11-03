use near_sdk::json_types::{U64, U128};
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{AccountId, NearToken, testing_env};

use crate::{Contract, EnvelopeInput, SpenderInput};

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn context(predecessor: &str, deposit: NearToken) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(account("earmark.testnet"))
        .predecessor_account_id(account(predecessor))
        .attached_deposit(deposit);
    builder
}

fn contract() -> Contract {
    testing_env!(context("earmark.testnet", NearToken::from_near(0)).build());
    Contract::new(
        account("club.sputnik-dao.near"),
        vec![account("usdc.near")],
        None,
    )
}

fn input() -> EnvelopeInput {
    EnvelopeInput {
        name: "News".to_owned(),
        token_id: account("usdc.near"),
        spenders: vec![SpenderInput {
            account_id: account("alice.near"),
            auto_limit: U128(10),
            period_cap: U128(200),
        }],
        approvers: vec![account("bob.near")],
        one_approver_limit: U128(50),
        raise_ceiling: U128(25),
        payees: vec![account("carol.near")],
        period_secs: U64(2_592_000),
        period_cap: U128(500),
        pending_ttl_secs: None,
    }
}

#[test]
fn dao_creates_envelope() {
    let mut c = contract();
    testing_env!(context("club.sputnik-dao.near", NearToken::from_millinear(100)).build());
    let id = c.create_envelope(input());

    let view = c.get_envelope(id).expect("envelope exists");
    assert_eq!(view.name, "News");
    assert_eq!(view.available, U128(0));
    assert_eq!(view.payees, vec![account("carol.near")]);
    assert!(
        get_logs()
            .iter()
            .any(|l| l.contains("\"event\":\"envelope_created\""))
    );
}

#[test]
#[should_panic(expected = "not_dao")]
fn non_dao_cannot_create_envelope() {
    let mut c = contract();
    testing_env!(context("alice.near", NearToken::from_millinear(100)).build());
    c.create_envelope(input());
}

#[test]
#[should_panic(expected = "insufficient_storage_deposit")]
fn create_envelope_requires_storage_deposit() {
    let mut c = contract();
    testing_env!(context("club.sputnik-dao.near", NearToken::from_near(0)).build());
    c.create_envelope(input());
}

fn funded_contract() -> (Contract, U64) {
    let mut c = contract();
    testing_env!(context("club.sputnik-dao.near", NearToken::from_millinear(100)).build());
    let id = c.create_envelope(input());
    testing_env!(context("usdc.near", NearToken::from_yoctonear(1)).build());
    (c, id)
}

#[test]
fn dao_funds_envelope() {
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    use near_sdk::PromiseOrValue;

    let (mut c, id) = funded_contract();
    let msg = format!("{{\"envelope_id\":\"{}\"}}", id.0);
    let refund = c.ft_on_transfer(account("club.sputnik-dao.near"), U128(300), msg);

    assert!(matches!(refund, PromiseOrValue::Value(U128(0))));
    let view = c.get_envelope(id).unwrap();
    assert_eq!((view.balance, view.available), (U128(300), U128(300)));
}

#[test]
fn non_dao_deposit_is_refunded() {
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    use near_sdk::PromiseOrValue;

    let (mut c, id) = funded_contract();
    let msg = format!("{{\"envelope_id\":\"{}\"}}", id.0);
    let refund = c.ft_on_transfer(account("alice.near"), U128(300), msg);

    assert!(matches!(refund, PromiseOrValue::Value(U128(300))));
    assert_eq!(c.get_envelope(id).unwrap().balance, U128(0));
}
