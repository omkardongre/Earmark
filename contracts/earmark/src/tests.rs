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
    // R21: a failed transfer never counts for the payee.
    assert_eq!(c.get_payee_record(account("carol.near")).paid_count, 0);
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

/// Files escalation `id` (amount 300, above the one-approver limit) as DAO proposal `proposal`.
fn escalate(c: &mut Contract, id: &str, work: &str, proposal: u64) {
    at("alice.near", 0);
    request(c, id, 300, work);
    at("earmark.testnet", 0);
    c.on_escalated(id.to_owned(), Ok(near_sdk::serde_json::json!(proposal)));
}

fn settle(
    c: &mut Contract,
    id: &str,
    proposal: Result<near_sdk::serde_json::Value, ()>,
) -> crate::RequestStatus {
    let policy = near_sdk::serde_json::json!({ "proposal_period": "604800000000000" });
    c.on_settle(
        id.to_owned(),
        proposal.map_err(|()| near_sdk::PromiseError::Failed),
        Ok(policy),
    )
}

fn open_escalations(c: &Contract) -> u32 {
    let view = c.get_envelope(U64(0)).unwrap();
    view.spenders[0].1.open_escalations
}

#[test]
fn settle_escalation_records_each_dao_outcome() {
    use crate::RequestStatus::{Escalated, EscalationClosed, PaidByDao};
    use near_sdk::serde_json::json;
    let mut c = spending_contract(60);
    escalate(&mut c, "e1", "series-1", 1);
    escalate(&mut c, "e2", "series-2", 2);
    escalate(&mut c, "e3", "series-3", 3);
    escalate(&mut c, "e4", "series-4", 4);
    assert_eq!(open_escalations(&c), 4);

    // Approved, filed before R22 so it paid the payee directly (no action log to time it):
    // counted for spender and payee, work claim kept.
    at("earmark.testnet", 10);
    assert_eq!(
        settle(&mut c, "e1", Ok(json!({ "status": "Approved" }))),
        PaidByDao
    );
    assert_eq!(
        settle(&mut c, "e1", Ok(json!({ "status": "Rejected" }))),
        PaidByDao
    );
    assert_eq!(c.get_record(account("alice.near")).paid_count, 1);
    let payee = c.get_payee_record(account("carol.near"));
    assert_eq!((payee.paid_count, payee.paid_total), (1, U128(300)));
    assert_eq!(
        check(&c, "x1", "carol.near", 5, "series-1").blocked,
        Some(crate::BlockReason::DuplicateWork)
    );

    // Rejected, and removed (Sputnik: ERR_NO_PROPOSAL): closed, work claim freed.
    assert_eq!(
        settle(&mut c, "e2", Ok(json!({ "status": "Rejected" }))),
        EscalationClosed
    );
    assert_eq!(settle(&mut c, "e3", Err(())), EscalationClosed);
    assert_eq!(
        c.get_request("e3".to_owned()).unwrap().failure.as_deref(),
        Some("removed")
    );
    assert_eq!(check(&c, "x2", "carol.near", 5, "series-2").blocked, None);

    // Still in the vote: no change. Past the voting period: expired.
    let open = json!({ "status": "InProgress", "submission_time": "0" });
    assert_eq!(settle(&mut c, "e4", Ok(open.clone())), Escalated);
    at("earmark.testnet", 604_801);
    assert_eq!(settle(&mut c, "e4", Ok(open)), EscalationClosed);

    assert_eq!(open_escalations(&c), 0);
    assert_eq!(c.get_payee_record(account("carol.near")).paid_count, 1);
}

/// R22: the DAO's money comes to Earmark, which pays the payee and only then says paid.
#[test]
fn dao_money_for_an_escalation_is_paid_out_once() {
    use crate::RequestStatus::{DaoFunded, Escalated, EscalationClosed, PaidByDao, Paying};
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    use near_sdk::serde_json::json;
    use near_sdk::{PromiseError, PromiseOrValue};
    let mut c = spending_contract(60);
    escalate(&mut c, "e1", "series-1", 1);
    escalate(&mut c, "e2", "series-2", 2);
    let msg = |id: &str| json!({ "request_id": id }).to_string();
    let dao = || account("club.sputnik-dao.near");
    let status = |c: &Contract, id: &str| c.get_request(id.to_owned()).unwrap().status;
    let refunded = |r: PromiseOrValue<U128>| match r {
        PromiseOrValue::Value(U128(v)) => v,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    };

    // Only the exact amount, once. It's paid out in the same call.
    testing_env!(context("usdc.near", NearToken::from_yoctonear(1)).build());
    assert_eq!(refunded(c.ft_on_transfer(dao(), U128(299), msg("e1"))), 299);
    assert_eq!(refunded(c.ft_on_transfer(dao(), U128(300), msg("e1"))), 0);
    assert_eq!(status(&c, "e1"), Paying);
    assert_eq!(refunded(c.ft_on_transfer(dao(), U128(300), msg("e1"))), 300);

    // The payout fails: the money stays held and anyone can retry.
    at("earmark.testnet", 10);
    assert_eq!(
        c.on_dao_payout("e1".into(), Err(PromiseError::Failed)),
        DaoFunded
    );
    assert_eq!(c.get_payee_record(account("carol.near")).paid_count, 0);
    at("dave.near", 10);
    let _ = c.settle_escalation("e1".into());
    assert_eq!(status(&c, "e1"), Paying);
    at("earmark.testnet", 10);
    assert_eq!(c.on_dao_payout("e1".into(), Ok(())), PaidByDao);
    assert_eq!(c.get_payee_record(account("carol.near")).paid_count, 1);
    // Deleting the proposal after it paid frees nothing.
    assert_eq!(settle(&mut c, "e1", Err(())), PaidByDao);
    assert_eq!(
        check(&c, "x1", "carol.near", 5, "series-1").blocked,
        Some(crate::BlockReason::DuplicateWork)
    );

    // e2 approved, but its money never arrived: closed 20 blocks after the vote, not before.
    let approved = json!({
        "status": "Approved",
        "kind": { "Transfer": { "receiver_id": "earmark.testnet" } },
        "last_actions_log": [{ "block_height": "100" }],
    });
    let block = |h: u64| {
        testing_env!(
            context("earmark.testnet", NearToken::from_near(0))
                .block_height(h)
                .build()
        )
    };
    block(119);
    assert_eq!(settle(&mut c, "e2", Ok(approved.clone())), Escalated);
    block(120);
    assert_eq!(settle(&mut c, "e2", Ok(approved)), EscalationClosed);
    assert_eq!(
        c.get_request("e2".to_owned()).unwrap().failure.as_deref(),
        Some("dao_payment_returned")
    );
    assert_eq!(open_escalations(&c), 0);
}

#[test]
fn escalation_from_before_the_upgrade_settles_once_after_it() {
    use near_sdk::serde_json::json;
    let mut c = spending_contract(60);
    escalate(&mut c, "e1", "series-1", 1);

    // Write the state in the layout deployed before R18–R21, then run `migrate`.
    let Contract {
        dao_id,
        token_ids,
        envelopes,
        next_envelope_id,
        loosen_delay_secs,
        requests,
        work_claims,
        work_overrides,
        records,
        eligibility,
        changes,
        queued_ids,
        next_change_id,
        pending_payees,
        ..
    } = c;
    let old = crate::ContractV1 {
        dao_id,
        token_ids,
        envelopes,
        next_envelope_id,
        loosen_delay_secs,
        requests,
        work_claims,
        work_overrides,
        records,
        eligibility,
        changes,
        queued_ids,
        next_change_id,
        pending_payees,
    };
    near_sdk::env::state_write(&old);
    drop(old);
    let mut c = Contract::migrate();

    at("earmark.testnet", 10);
    let approved = || Ok(json!({ "status": "Approved" }));
    assert_eq!(
        settle(&mut c, "e1", approved()),
        crate::RequestStatus::PaidByDao
    );
    assert_eq!(
        settle(&mut c, "e1", approved()),
        crate::RequestStatus::PaidByDao
    );
    assert_eq!(c.get_record(account("alice.near")).paid_count, 1);
    assert_eq!(open_escalations(&c), 0);
}

#[test]
fn request_cap_and_storage_float_block_new_requests() {
    use crate::BlockReason;
    let mut c = spending_contract(200);
    for i in 0..crate::request::MAX_REQUESTS_PER_PERIOD {
        at("alice.near", 0);
        request(&mut c, &format!("r{i}"), 1, &format!("issue-{i}"));
    }
    assert_eq!(
        check(&c, "next", "carol.near", 1, "issue-x").blocked,
        Some(BlockReason::TooManyRequests)
    );
    // A new period resets the count.
    at("alice.near", 2_592_000);
    assert_eq!(check(&c, "next", "carol.near", 1, "issue-x").blocked, None);

    testing_env!(
        context("alice.near", NearToken::from_near(0))
            .block_timestamp(2_592_000 * 1_000_000_000)
            .account_balance(NearToken::from_millinear(1))
            .build()
    );
    assert_eq!(
        check(&c, "next", "carol.near", 1, "issue-x").blocked,
        Some(BlockReason::InsufficientStorageFloat)
    );
}

#[test]
#[should_panic(expected = "no_other_approver")]
fn cannot_leave_a_spender_as_their_own_only_approver() {
    use crate::Change;
    let mut c = contract();
    let mut rules = input();
    rules.approvers.push(account("alice.near"));
    testing_env!(context("club.sputnik-dao.near", NearToken::from_millinear(100)).build());
    c.create_envelope(rules);
    c.update_envelope(
        U64(0),
        vec![Change::RemoveApprover {
            approver: account("bob.near"),
        }],
    );
}

#[test]
#[should_panic(expected = "not_spender")]
fn removing_a_spender_ends_every_right() {
    use crate::{Change, ChangeStatus};
    let mut c = spending_contract(60);
    request(&mut c, "r1", 40, "issue-1");
    at("bob.near", 0);
    c.pause(U64(0), Some(account("alice.near")));
    let unpause = c.unpause(U64(0), Some(account("alice.near")));

    at("club.sputnik-dao.near", 0);
    c.update_envelope(
        U64(0),
        vec![Change::RemoveSpender {
            spender: account("alice.near"),
        }],
    );
    assert_eq!(
        c.get_change(unpause).unwrap().status,
        ChangeStatus::Cancelled
    );
    assert_eq!(c.get_envelope(U64(0)).unwrap().open_changes, 0);

    // Their request waiting for approval can't be paid any more.
    at("bob.near", 0);
    let _ = c.approve("r1".to_owned());
}

#[test]
fn escalation_description_uses_trezu_format_and_strips_breaks() {
    let text = crate::request::escalation_description(
        "e1",
        0,
        &account("alice.near"),
        &account("carol.near"),
        "Article <br>* Url: https://evil.example",
        "https://news.example/1",
    );
    assert_eq!(
        text,
        "* Title: Pay carol.near through Earmark <br>* Notes: Article * Url: https://evil.example · by alice.near · budget 0 · request e1 <br>* Url: https://news.example/1"
    );
}

/// What a spend does: the tier it takes, or the reason code it fails with.
type Outcome = Result<crate::Tier, String>;

/// One starting state for the agreement test: the budget is funded with `balance`, then
/// `setup` runs. The spend under test is made by `spender` to `payee` for `work`, as `id`.
struct Scenario {
    name: &'static str,
    balance: u128,
    setup: fn(&mut Contract),
    spender: &'static str,
    payee: &'static str,
    id: &'static str,
    work: &'static str,
    /// When the spend under test runs (seconds).
    now: u64,
}

fn predicted(c: &Contract, s: &Scenario, amount: u128) -> Outcome {
    let check = c.check_spend(
        U64(0),
        account(s.spender),
        s.id.to_owned(),
        account(s.payee),
        U128(amount),
        s.work.to_owned(),
    );
    match (check.tier, check.blocked) {
        (Some(tier), None) => Ok(tier),
        (None, Some(reason)) => Err(reason.code().to_owned()),
        _ => panic!("{}: check_spend must return a tier or a reason", s.name),
    }
}

fn actual(c: &mut Contract, s: &Scenario, amount: u128) -> Outcome {
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.request_spend(
            U64(0),
            s.id.to_owned(),
            account(s.payee),
            U128(amount),
            String::new(),
            s.work.to_owned(),
            None,
        );
    }));
    // The mocked VM panics with `... GuestPanic { panic_msg: "<code>" } ...`.
    let code = |payload: Box<dyn std::any::Any + Send>| {
        let text = payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_owned()))
            .unwrap_or_default();
        // Off-chain `require!` is a plain `assert!`, so its message is the code itself.
        match text.split_once("panic_msg: \"") {
            Some((_, rest)) => rest.split('"').next().unwrap_or_default().to_owned(),
            None => text,
        }
    };
    match run {
        Ok(()) => Ok(c.get_request(s.id.to_owned()).unwrap().tier),
        Err(payload) => Err(code(payload)),
    }
}

/// R17: for every case the view predicts exactly what `request_spend` then does. Rules: auto
/// limit 10, one-approver limit 50, spender period cap 200; amounts sit on each side of them.
#[test]
fn check_spend_agrees_with_request_spend() {
    use crate::Tier::{Auto, Escalate, OneApprover};
    let base = Scenario {
        name: "fresh",
        balance: 60,
        setup: |_| {},
        spender: "alice.near",
        payee: "carol.near",
        id: "r",
        work: "w",
        now: 0,
    };
    let near_cap = |c: &mut Contract| {
        for i in 0..4 {
            request(c, &format!("r{i}"), 48, &format!("issue-{i}"));
        }
    };
    let scenarios = [
        Scenario { ..base },
        Scenario {
            name: "40 reserved",
            setup: |c| request(c, "r0", 40, "issue-0"),
            ..base
        },
        Scenario {
            name: "192 of the 200 period cap used",
            balance: 300,
            setup: near_cap,
            ..base
        },
        Scenario {
            name: "cap used last period, new period not rolled yet",
            balance: 300,
            setup: near_cap,
            now: 2_592_000,
            ..base
        },
        Scenario {
            name: "empty work link",
            work: " ",
            ..base
        },
        Scenario {
            name: "same work already paying",
            setup: |c| request(c, "r0", 5, "w"),
            ..base
        },
        Scenario {
            name: "same work, overridden",
            setup: |c| {
                request(c, "r0", 5, "w");
                at("bob.near", 0);
                c.override_duplicate(
                    U64(0),
                    account("alice.near"),
                    account("carol.near"),
                    "w".to_owned(),
                    "second instalment".to_owned(),
                );
            },
            ..base
        },
        Scenario {
            name: "same request id",
            setup: |c| request(c, "r", 5, "issue-0"),
            ..base
        },
        Scenario {
            name: "payee not allowed",
            payee: "dave.near",
            ..base
        },
        Scenario {
            name: "payee in delay",
            setup: |c| {
                at("bob.near", 0);
                c.approve_payee(U64(0), account("dave.near"));
            },
            payee: "dave.near",
            ..base
        },
        Scenario {
            name: "spender paused",
            setup: |c| {
                at("bob.near", 0);
                c.pause(U64(0), Some(account("alice.near")));
            },
            ..base
        },
        Scenario {
            name: "budget paused",
            setup: |c| {
                at("bob.near", 0);
                c.pause(U64(0), None);
            },
            ..base
        },
        Scenario {
            name: "not a spender",
            spender: "eve.near",
            ..base
        },
        Scenario {
            name: "budget closed",
            setup: |c| {
                at("club.sputnik-dao.near", 0);
                let _ = c.close_envelope(U64(0));
            },
            ..base
        },
        Scenario {
            name: "five open escalations",
            setup: |c| {
                for i in 0..crate::request::MAX_OPEN_ESCALATIONS {
                    request(c, &format!("e{i}"), 300, &format!("issue-{i}"));
                }
            },
            ..base
        },
    ];
    let amounts = [0, 1, 10, 11, 21, 50, 51, 300];

    let mut seen = std::collections::BTreeSet::new();
    for s in &scenarios {
        for amount in amounts {
            // Mocked chain storage is per thread and outlives `testing_env!`, so each case
            // gets a fresh thread.
            let (predicted, actual) = std::thread::scope(|t| {
                t.spawn(|| {
                    let mut c = spending_contract(s.balance);
                    (s.setup)(&mut c);
                    at(s.spender, s.now);
                    (predicted(&c, s, amount), actual(&mut c, s, amount))
                })
                .join()
                .unwrap()
            });
            assert_eq!(predicted, actual, "{}, amount {amount}", s.name);
            seen.insert(format!("{predicted:?}"));
        }
    }
    // The cases reach every tier and each block reason they are built for.
    let expected = [
        Ok(Auto),
        Ok(OneApprover),
        Ok(Escalate),
        Err("closed"),
        Err("paused"),
        Err("not_spender"),
        Err("duplicate_request"),
        Err("payee_not_allowed"),
        Err("payee_pending"),
        Err("duplicate_work"),
        Err("over_available"),
        Err("over_period_cap"),
        Err("too_many_escalations"),
        Err("invalid_input"),
    ];
    for outcome in expected {
        let outcome: Outcome = outcome.map_err(str::to_owned);
        assert!(
            seen.contains(&format!("{outcome:?}")),
            "never hit {outcome:?}"
        );
    }
}

#[test]
#[should_panic(expected = "budget_open")]
fn contract_cannot_be_deleted_while_a_budget_is_open() {
    let mut c = spending_contract(60);
    at("club.sputnik-dao.near", 0);
    let _ = c.delete_contract();
}

// --- Tasks (bounties) and contributor trust ---

fn task(c: &mut Contract, amount: u128, claim_days: Option<u32>) -> U64 {
    c.post_task(
        U64(0),
        "Write the guide".to_owned(),
        String::new(),
        U128(amount),
        None,
        claim_days,
    )
}

/// Posts, claims, submits and accepts a task; returns its id and the payment's request id.
fn accepted_task(c: &mut Contract, amount: u128, work: &str, t: u64) -> (U64, String) {
    at("alice.near", t);
    let id = task(c, amount, None);
    at("carol.near", t);
    c.claim_task(id);
    c.submit_work(id, work.to_owned(), None);
    at("alice.near", t);
    let _ = c.accept_task(id);
    (id, c.get_task(id).unwrap().request_id.unwrap())
}

#[test]
fn task_reserves_at_posting_and_pays_through_the_tiers() {
    use crate::{TaskStatus, Tier};
    let mut c = spending_contract(100);
    at("alice.near", 0);
    let id = task(&mut c, 20, None);
    let view = c.get_envelope(U64(0)).unwrap();
    assert_eq!((view.available, view.committed), (U128(80), U128(20)));

    at("carol.near", 1);
    c.claim_task(id);
    c.submit_work(id, "https://example.com/pr/1".to_owned(), None);
    assert_eq!(c.check_accept(id).tier, Some(Tier::OneApprover));
    at("alice.near", 2);
    let _ = c.accept_task(id);
    let request_id = c.get_task(id).unwrap().request_id.unwrap();
    assert_eq!(c.get_envelope(U64(0)).unwrap().committed, U128(20));

    at("bob.near", 3);
    let _ = c.approve(request_id.clone());
    at("earmark.testnet", 4);
    c.on_paid(request_id, Ok(()));

    assert_eq!(c.get_task(id).unwrap().status, TaskStatus::Paid);
    let view = c.get_envelope(U64(0)).unwrap();
    assert_eq!((view.balance, view.committed), (U128(80), U128(0)));
    let trust = c.get_contributor_trust(U64(0), account("carol.near"));
    assert_eq!((trust.record.tasks_paid, trust.trusted), (1, false));
}

#[test]
fn trusted_contributor_skips_the_approver_until_a_strike() {
    use crate::{TaskRules, Tier};
    let mut c = spending_contract(200);
    at("club.sputnik-dao.near", 0);
    c.set_task_rules(
        U64(0),
        TaskRules {
            trusted_limit: U128(40),
            min_tasks: 1,
            min_days: 0,
            strike_days: 90,
            min_task_amount: U128(0),
        },
    );
    assert_eq!(
        check(&c, "x", "carol.near", 30, "w").tier,
        Some(Tier::OneApprover)
    );

    let (_, request_id) = accepted_task(&mut c, 5, "https://example.com/pr/1", 1);
    at("earmark.testnet", 2);
    c.on_paid(request_id, Ok(()));
    // Lead's own limit is 10; a trusted contributor clears at once up to 40, not above.
    assert_eq!(
        check(&c, "x", "carol.near", 30, "w").tier,
        Some(Tier::Trusted)
    );
    assert_eq!(
        check(&c, "x", "carol.near", 45, "w").tier,
        Some(Tier::OneApprover)
    );

    at("alice.near", 3);
    let id = task(&mut c, 5, None);
    at("carol.near", 3);
    c.claim_task(id);
    c.submit_work(id, "https://example.com/pr/2".to_owned(), None);
    at("alice.near", 4);
    c.reject_work(id, "copied from another repo".to_owned(), true);
    assert_eq!(
        check(&c, "x", "carol.near", 30, "w").tier,
        Some(Tier::OneApprover)
    );
}

#[test]
fn failed_task_payment_holds_again_and_close_cancels() {
    use crate::TaskStatus;
    use near_sdk::PromiseResult;
    let mut c = spending_contract(100);
    let (id, request_id) = accepted_task(&mut c, 8, "https://example.com/pr/1", 0);
    assert_eq!(c.get_envelope(U64(0)).unwrap().in_flight, U128(8));

    testing_env!(
        context("earmark.testnet", NearToken::from_near(0)).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed],
    );
    c.on_paid(request_id, Err(near_sdk::PromiseError::Failed));
    let t = c.get_task(id).unwrap();
    assert_eq!(
        (t.status, t.reason.as_deref()),
        (TaskStatus::Submitted, Some("transfer_failed"))
    );
    let view = c.get_envelope(U64(0)).unwrap();
    assert_eq!((view.committed, view.in_flight), (U128(8), U128(0)));

    at("club.sputnik-dao.near", 1);
    let _ = c.close_envelope(U64(0));
    assert_eq!(c.get_task(id).unwrap().status, TaskStatus::Cancelled);
    assert_eq!(c.get_envelope(U64(0)).unwrap().committed, U128(0));
}

#[test]
#[should_panic(expected = "too_many_claims")]
fn claims_expire_and_one_is_open_at_a_time() {
    use crate::TaskStatus;
    let mut c = spending_contract(100);
    at("alice.near", 0);
    let first = task(&mut c, 5, Some(1));
    let second = task(&mut c, 5, Some(1));
    at("carol.near", 0);
    c.claim_task(first);
    // After the 1-day deadline anyone can open it again.
    at("someone.near", 86_401);
    c.release_claim(first);
    assert_eq!(c.get_task(first).unwrap().status, TaskStatus::Open);
    at("carol.near", 86_402);
    c.claim_task(first);
    c.claim_task(second);
}

#[test]
fn tasks_survive_the_upgrade_from_the_r23_layout() {
    let mut c = spending_contract(60);
    let Contract {
        dao_id,
        token_ids,
        envelopes,
        next_envelope_id,
        loosen_delay_secs,
        requests,
        work_claims,
        work_overrides,
        records,
        eligibility,
        changes,
        queued_ids,
        next_change_id,
        pending_payees,
        payee_records,
        request_counts,
        ..
    } = c;
    let old = crate::ContractV2 {
        dao_id,
        token_ids,
        envelopes,
        next_envelope_id,
        loosen_delay_secs,
        requests,
        work_claims,
        work_overrides,
        records,
        eligibility,
        changes,
        queued_ids,
        next_change_id,
        pending_payees,
        payee_records,
        request_counts,
    };
    near_sdk::env::state_write(&old);
    drop(old);
    c = Contract::migrate();

    at("alice.near", 0);
    let id = task(&mut c, 20, None);
    assert_eq!(id, U64(0));
    assert_eq!(c.get_envelope(U64(0)).unwrap().available, U128(40));
}
