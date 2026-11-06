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

/// Budget 0 funded with `balance`, called as spender `alice.near`.
fn spending_contract(balance: u128) -> Contract {
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    let (mut c, id) = funded_contract();
    let msg = format!("{{\"envelope_id\":\"{}\"}}", id.0);
    let _ = c.ft_on_transfer(account("club.sputnik-dao.near"), U128(balance), msg);
    testing_env!(context("alice.near", NearToken::from_near(0)).build());
    c
}

fn request(c: &mut Contract, id: &str, amount: u128, work: &str) {
    let _ = c.request_spend(
        U64(0),
        id.to_owned(),
        account("carol.near"),
        U128(amount),
        String::new(),
        work.to_owned(),
        None,
    );
}

#[test]
fn second_request_cannot_spend_a_reservation() {
    let mut c = spending_contract(60);
    request(&mut c, "r1", 40, "issue-1");
    let check = c.check_spend(
        U64(0),
        account("alice.near"),
        "r2".to_owned(),
        account("carol.near"),
        U128(40),
        "issue-2".to_owned(),
    );
    assert_eq!(check.blocked, Some(crate::BlockReason::OverAvailable));

    let view = c.get_envelope(U64(0)).unwrap();
    assert_eq!((view.committed, view.available), (U128(40), U128(20)));
}

#[test]
fn escalation_reserves_nothing_and_blocks_duplicate_work() {
    let mut c = spending_contract(60);
    request(&mut c, "r1", 300, "invoice-7");
    let r = c.get_request("r1".to_owned()).unwrap();
    assert_eq!(r.tier, crate::Tier::Escalate);
    assert_eq!(c.get_envelope(U64(0)).unwrap().available, U128(60));

    let check = c.check_spend(
        U64(0),
        account("alice.near"),
        "r2".to_owned(),
        account("carol.near"),
        U128(5),
        "invoice-7".to_owned(),
    );
    assert_eq!(check.blocked, Some(crate::BlockReason::DuplicateWork));
}

#[test]
fn failed_transfer_releases_reservation_and_work() {
    use near_sdk::PromiseResult;
    let mut c = spending_contract(60);
    request(&mut c, "r1", 8, "issue-1");
    assert_eq!(c.get_envelope(U64(0)).unwrap().in_flight, U128(8));

    testing_env!(
        context("earmark.testnet", NearToken::from_near(0)).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed],
    );
    c.on_paid("r1".to_owned(), Err(near_sdk::PromiseError::Failed));

    let view = c.get_envelope(U64(0)).unwrap();
    assert_eq!(
        (view.in_flight, view.available, view.period_spent),
        (U128(0), U128(60), U128(0))
    );
    assert_eq!(
        c.get_request("r1".to_owned()).unwrap().status,
        crate::RequestStatus::Failed
    );
    let retry = c.check_spend(
        U64(0),
        account("alice.near"),
        "r2".to_owned(),
        account("carol.near"),
        U128(8),
        "issue-1".to_owned(),
    );
    assert_eq!(retry.tier, Some(crate::Tier::Auto));
}

#[test]
#[should_panic(expected = "self_approval")]
fn approver_cannot_approve_own_request() {
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    let mut c = contract();
    let mut rules = input();
    rules.approvers.push(account("alice.near"));
    testing_env!(context("club.sputnik-dao.near", NearToken::from_millinear(100)).build());
    c.create_envelope(rules);
    testing_env!(context("usdc.near", NearToken::from_yoctonear(1)).build());
    let _ = c.ft_on_transfer(
        account("club.sputnik-dao.near"),
        U128(60),
        "{\"envelope_id\":\"0\"}".to_owned(),
    );
    testing_env!(context("alice.near", NearToken::from_near(0)).build());
    request(&mut c, "r1", 40, "issue-1");
    let _ = c.approve("r1".to_owned());
}

#[test]
fn pending_request_expires_and_releases_reservation() {
    let mut c = spending_contract(60);
    request(&mut c, "r1", 40, "issue-1");

    let ttl_ns = crate::DEFAULT_PENDING_TTL_SECS * 1_000_000_000;
    testing_env!(
        context("anyone.near", NearToken::from_near(0))
            .block_timestamp(ttl_ns)
            .build()
    );
    c.expire("r1".to_owned());

    let view = c.get_envelope(U64(0)).unwrap();
    assert_eq!((view.committed, view.available), (U128(0), U128(60)));
    assert_eq!(
        c.get_request("r1".to_owned()).unwrap().status,
        crate::RequestStatus::Expired
    );
}

fn at(predecessor: &str, secs: u64) {
    testing_env!(
        context(predecessor, NearToken::from_near(0))
            .block_timestamp(secs * 1_000_000_000)
            .build()
    );
}

fn check(c: &Contract, id: &str, payee: &str, amount: u128, work: &str) -> crate::SpendCheck {
    c.check_spend(
        U64(0),
        account("alice.near"),
        id.to_owned(),
        account(payee),
        U128(amount),
        work.to_owned(),
    )
}

#[test]
fn added_payee_waits_out_the_delay_and_removal_is_instant() {
    use crate::{BlockReason, ChangeStatus};
    let mut c = spending_contract(60);
    at("bob.near", 0);
    let change = c.approve_payee(U64(0), account("dave.near"));
    assert_eq!(
        check(&c, "r1", "dave.near", 5, "w").blocked,
        Some(BlockReason::PayeePending)
    );

    let delay = crate::DEFAULT_LOOSEN_DELAY_SECS;
    at("anyone.near", delay);
    assert_eq!(c.apply_change(change), ChangeStatus::Applied);
    assert_eq!(check(&c, "r1", "dave.near", 5, "w").blocked, None);

    at("bob.near", delay);
    c.remove_payee(U64(0), account("dave.near"));
    assert_eq!(
        check(&c, "r1", "dave.near", 5, "w").blocked,
        Some(BlockReason::PayeeNotAllowed)
    );
}

#[test]
#[should_panic(expected = "not_yet")]
fn queued_change_cannot_apply_early() {
    let mut c = spending_contract(60);
    at("bob.near", 0);
    c.pause(U64(0), None);
    let change = c.unpause(U64(0), None);
    at("anyone.near", crate::DEFAULT_LOOSEN_DELAY_SECS - 1);
    c.apply_change(change);
}

#[test]
#[should_panic(expected = "above_ceiling")]
fn queued_raise_fails_after_dao_lowers_ceiling() {
    use crate::Change;
    let mut c = spending_contract(60);
    at("club.sputnik-dao.near", 0);
    let queued = c.update_envelope(
        U64(0),
        vec![Change::SpenderAutoLimit {
            spender: account("alice.near"),
            amount: U128(20),
        }],
    );
    c.update_envelope(U64(0), vec![Change::RaiseCeiling { amount: U128(15) }]);
    at("anyone.near", crate::DEFAULT_LOOSEN_DELAY_SECS);
    c.apply_change(queued[0].unwrap());
}

#[test]
#[should_panic(expected = "not_eligible")]
fn approver_cannot_raise_a_new_spender() {
    let mut c = spending_contract(60);
    at("bob.near", 0);
    c.raise_limit(U64(0), account("alice.near"), U128(20));
}

#[test]
fn pause_by_approver_blocks_at_once() {
    let mut c = spending_contract(60);
    at("bob.near", 0);
    c.pause(U64(0), Some(account("alice.near")));
    assert_eq!(
        check(&c, "r1", "carol.near", 5, "w").blocked,
        Some(crate::BlockReason::Paused)
    );
}

#[test]
fn override_allows_one_repeat_of_the_same_work() {
    let mut c = spending_contract(60);
    request(&mut c, "r1", 40, "invoice-1");
    at("bob.near", 0);
    c.override_duplicate(
        U64(0),
        account("alice.near"),
        account("carol.near"),
        "invoice-1".to_owned(),
        "second instalment".to_owned(),
    );
    at("alice.near", 0);
    assert_eq!(check(&c, "r2", "carol.near", 5, "invoice-1").blocked, None);
    request(&mut c, "r2", 5, "invoice-1");
    assert_eq!(
        check(&c, "r3", "carol.near", 5, "invoice-1").blocked,
        Some(crate::BlockReason::DuplicateWork)
    );
}

#[test]
fn close_rejects_pending_and_returns_free_balance() {
    let mut c = spending_contract(60);
    request(&mut c, "r1", 40, "issue-1");
    at("club.sputnik-dao.near", 0);
    let _ = c.close_envelope(U64(0));

    let view = c.get_envelope(U64(0)).unwrap();
    assert!(view.closed);
    assert_eq!(
        (view.balance, view.committed, view.available),
        (U128(0), U128(0), U128(0))
    );
    assert_eq!(
        c.get_request("r1".to_owned()).unwrap().status,
        crate::RequestStatus::Rejected
    );
}

#[test]
fn list_requests_returns_newest_first() {
    let mut c = spending_contract(60);
    request(&mut c, "r1", 5, "issue-1");
    request(&mut c, "r2", 40, "issue-2");
    let ids: Vec<String> = c
        .list_requests(U64(0), None, None)
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    assert_eq!(ids, vec!["r2", "r1"]);
    assert_eq!(c.list_requests(U64(0), Some(U64(1)), Some(1))[0].0, "r1");
    assert_eq!(c.get_envelope(U64(0)).unwrap().request_count, U64(2));
}

#[test]
#[should_panic(expected = "not_dao")]
fn only_dao_can_upgrade() {
    let c = contract();
    testing_env!(context("earmark.testnet", NearToken::from_near(0)).build());
    let _ = c.upgrade();
}
