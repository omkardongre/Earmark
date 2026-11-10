//! Sandbox tests on a local NEAR node with a real NEP-141 token.

use std::sync::Arc;

use near_api::signer::generate_secret_key;
use near_api::types::transaction::actions::FunctionCallPermission;
use near_api::types::{AccessKeyPermission, AccountId, Data, NearGas, NearToken};
use near_api::{Account, Contract, NetworkConfig, Signer, Tokens};
use near_sandbox::{GenesisAccount, Sandbox, SandboxConfig};
use serde_json::{Value, json};
use testresult::TestResult;

struct Actor {
    id: AccountId,
    signer: Arc<Signer>,
}

fn actor(account: &GenesisAccount) -> TestResult<Actor> {
    Ok(Actor {
        id: account.account_id.clone(),
        signer: Signer::from_secret_key(account.private_key.parse()?)?,
    })
}

async fn call(
    net: &NetworkConfig,
    who: &Actor,
    contract: &AccountId,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> TestResult {
    call_gas(net, who, contract, method, args, deposit, 150).await
}

async fn call_gas(
    net: &NetworkConfig,
    who: &Actor,
    contract: &AccountId,
    method: &str,
    args: Value,
    deposit: NearToken,
    tgas: u64,
) -> TestResult {
    Contract(contract.clone())
        .call_function(method, args)
        .transaction()
        .gas(NearGas::from_tgas(tgas))
        .deposit(deposit)
        .with_signer(who.id.clone(), who.signer.clone())
        .send_to(net)
        .await?
        .into_result()?;
    Ok(())
}

/// Error text of a call that must fail, or an error if it succeeded.
async fn call_err(
    net: &NetworkConfig,
    who: &Actor,
    contract: &AccountId,
    method: &str,
    args: Value,
) -> TestResult<String> {
    let sent = Contract(contract.clone())
        .call_function(method, args)
        .transaction()
        .gas(NearGas::from_tgas(150))
        .with_signer(who.id.clone(), who.signer.clone())
        .send_to(net)
        .await;
    match sent.map(|r| r.into_result()) {
        Ok(Ok(_)) => Err(format!("{method} should have failed").into()),
        Ok(Err(e)) => Ok(format!("{e:?}")),
        Err(e) => Ok(format!("{e:?}")),
    }
}

async fn view(
    net: &NetworkConfig,
    contract: &AccountId,
    method: &str,
    args: Value,
) -> TestResult<Value> {
    let data: Data<Value> = Contract(contract.clone())
        .call_function(method, args)
        .read_only()
        .fetch_from(net)
        .await?;
    Ok(data.data)
}

/// Reads a contract built by `make build` (`cargo near build`), so the test runs the same wasm
/// that gets deployed.
fn wasm(name: &str) -> TestResult<Vec<u8>> {
    let path = format!(
        "{}/../../target/near/{name}/{name}.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).map_err(|e| format!("{path}: {e}; run `make build` first").into())
}

/// A running sandbox with the token and Earmark deployed, and budget 0 funded with 100 by the
/// DAO. `alice` and `agent` are spenders (auto limit 10); `carol` is a registered payee and
/// `dave` an allowed payee who isn't registered with the token.
struct World {
    _sandbox: Sandbox,
    net: NetworkConfig,
    dao: Actor,
    token: Actor,
    earmark: Actor,
    alice: Actor,
    carol: Actor,
    dave: Actor,
    agent: Actor,
}

async fn setup() -> TestResult<World> {
    let names = ["dao", "token", "earmark", "alice", "carol", "dave", "agent"];
    let accounts: Vec<GenesisAccount> = names
        .iter()
        .map(|n| GenesisAccount::default_with_name(n.parse().unwrap()))
        .collect();
    let sandbox = Sandbox::start_sandbox_with_config(SandboxConfig {
        additional_accounts: accounts.clone(),
        ..Default::default()
    })
    .await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let mut actors = accounts.iter().map(actor).collect::<TestResult<Vec<_>>>()?;
    let agent = actors.pop().unwrap();
    let [dao, token, earmark, alice, carol, dave] =
        <[Actor; 6]>::try_from(actors).map_err(|_| "six actors")?;

    Contract::deploy(token.id.clone())
        .use_code(wasm("test_token")?)
        .with_init_call(
            "new",
            json!({ "owner_id": dao.id, "name": "Test USDC", "symbol": "tUSDC" }),
        )?
        .with_signer(token.signer.clone())
        .send_to(&net)
        .await?
        .into_result()?;
    Contract::deploy(earmark.id.clone())
        .use_code(wasm("earmark")?)
        .with_init_call("new", json!({ "dao_id": dao.id, "token_ids": [token.id] }))?
        .with_signer(earmark.signer.clone())
        .send_to(&net)
        .await?
        .into_result()?;

    let spender =
        |id: &AccountId| json!({ "account_id": id, "auto_limit": "10", "period_cap": "100" });
    let rules = json!({ "envelope": {
        "name": "Events", "token_id": token.id,
        "spenders": [spender(&alice.id), spender(&agent.id)],
        "approvers": [dao.id], "one_approver_limit": "50", "raise_ceiling": "20",
        "payees": [carol.id, dave.id], "period_secs": "2592000", "period_cap": "100",
    }});
    call(
        &net,
        &dao,
        &earmark.id,
        "create_envelope",
        rules,
        NearToken::from_millinear(100),
    )
    .await?;

    // Register the contract and carol with the token; dave stays unregistered.
    for account in [&earmark.id, &carol.id] {
        let args = json!({ "account_id": account, "registration_only": true });
        call(
            &net,
            &dao,
            &token.id,
            "storage_deposit",
            args,
            NearToken::from_millinear(10),
        )
        .await?;
    }
    call(
        &net,
        &dao,
        &token.id,
        "mint",
        json!({ "account_id": dao.id, "amount": "1000" }),
        NearToken::from_near(0),
    )
    .await?;
    let fund =
        json!({ "receiver_id": earmark.id, "amount": "100", "msg": "{\"envelope_id\":\"0\"}" });
    call(
        &net,
        &dao,
        &token.id,
        "ft_transfer_call",
        fund,
        NearToken::from_yoctonear(1),
    )
    .await?;

    Ok(World {
        _sandbox: sandbox,
        net,
        dao,
        token,
        earmark,
        alice,
        carol,
        dave,
        agent,
    })
}

fn spend(id: &str, payee: &AccountId) -> Value {
    json!({ "envelope_id": "0", "request_id": id, "payee": payee, "amount": "5", "memo": "", "work_ref": id })
}

fn status(request: &Value) -> &str {
    request["status"].as_str().unwrap_or_default()
}

#[tokio::test]
async fn payout_to_unregistered_payee_fails_and_releases_reservation() -> TestResult {
    let w = setup().await?;
    let net = &w.net;
    let zero = NearToken::from_near(0);
    call(
        net,
        &w.alice,
        &w.earmark.id,
        "request_spend",
        spend("to-dave", &w.dave.id),
        zero,
    )
    .await?;
    call(
        net,
        &w.alice,
        &w.earmark.id,
        "request_spend",
        spend("to-carol", &w.carol.id),
        zero,
    )
    .await?;

    let dave_request = view(
        net,
        &w.earmark.id,
        "get_request",
        json!({ "request_id": "to-dave" }),
    )
    .await?;
    assert_eq!(status(&dave_request), "failed", "{dave_request}");
    let carol_request = view(
        net,
        &w.earmark.id,
        "get_request",
        json!({ "request_id": "to-carol" }),
    )
    .await?;
    assert_eq!(status(&carol_request), "paid", "{carol_request}");

    let envelope = view(
        net,
        &w.earmark.id,
        "get_envelope",
        json!({ "envelope_id": "0" }),
    )
    .await?;
    assert_eq!(envelope["balance"], "95");
    assert_eq!(envelope["available"], "95");
    assert_eq!(envelope["in_flight"], "0");
    assert_eq!(envelope["period_spent"], "5");
    let carol_balance = view(
        net,
        &w.token.id,
        "ft_balance_of",
        json!({ "account_id": w.carol.id }),
    )
    .await?;
    assert_eq!(carol_balance, "5");

    // The DAO closes the budget and gets the free balance back.
    call(
        net,
        &w.dao,
        &w.earmark.id,
        "close_envelope",
        json!({ "envelope_id": "0" }),
        NearToken::from_near(0),
    )
    .await?;
    let envelope = view(
        net,
        &w.earmark.id,
        "get_envelope",
        json!({ "envelope_id": "0" }),
    )
    .await?;
    assert_eq!(
        (envelope["closed"].as_bool(), &envelope["balance"]),
        (Some(true), &json!("0"))
    );
    let dao_balance = view(
        net,
        &w.token.id,
        "ft_balance_of",
        json!({ "account_id": w.dao.id }),
    )
    .await?;
    assert_eq!(dao_balance, "995", "1000 minted, 100 funded, 95 returned");
    Ok(())
}

/// S5: an agent holding only a function-call key scoped to `request_spend` on Earmark can
/// request spends and nothing else. The protocol rejects the other calls before they run.
#[tokio::test]
async fn agent_key_can_only_request_spend() -> TestResult {
    let w = setup().await?;
    let net = &w.net;

    let agent_key = Signer::from_secret_key(generate_secret_key()?)?;
    let permission = AccessKeyPermission::FunctionCall(FunctionCallPermission {
        allowance: Some(NearToken::from_millinear(250)),
        receiver_id: w.earmark.id.to_string(),
        method_names: vec!["request_spend".to_owned()],
    });
    Account(w.agent.id.clone())
        .add_key(permission, agent_key.get_public_key().await?)
        .with_signer(w.agent.signer.clone())
        .send_to(net)
        .await?
        .into_result()?;
    let agent = Actor {
        id: w.agent.id.clone(),
        signer: agent_key,
    };

    // Allowed: request_spend, paid at once within the auto limit.
    call(
        net,
        &agent,
        &w.earmark.id,
        "request_spend",
        spend("agent-1", &w.carol.id),
        NearToken::from_near(0),
    )
    .await?;
    let request = view(
        net,
        &w.earmark.id,
        "get_request",
        json!({ "request_id": "agent-1" }),
    )
    .await?;
    assert_eq!(status(&request), "paid", "{request}");

    // Each of these is refused as an invalid transaction, before any contract code runs
    // (a contract panic would be an action error instead).
    let refused = |e: &str| e.contains("InvalidTransaction");
    // Another method on Earmark.
    let err = call_err(
        net,
        &agent,
        &w.earmark.id,
        "approve",
        json!({ "request_id": "agent-1" }),
    )
    .await?;
    assert!(refused(&err), "{err}");
    // Another contract: moving tokens directly.
    let transfer = json!({ "receiver_id": w.carol.id, "amount": "1" });
    let err = call_err(net, &agent, &w.token.id, "ft_transfer", transfer).await?;
    assert!(refused(&err), "{err}");
    // Any action other than a function call, such as sending NEAR.
    let sent = Tokens::account(agent.id.clone())
        .send_to(w.dao.id.clone())
        .near(NearToken::from_millinear(1))
        .with_signer(agent.signer.clone())
        .send_to(net)
        .await;
    let err = match sent.map(|r| r.into_result()) {
        Ok(Ok(_)) => return Err("NEAR transfer should have failed".into()),
        Ok(Err(e)) => format!("{e:?}"),
        Err(e) => format!("{e:?}"),
    };
    assert!(refused(&err), "{err}");

    let carol_balance = view(
        net,
        &w.token.id,
        "ft_balance_of",
        json!({ "account_id": w.carol.id }),
    )
    .await?;
    assert_eq!(
        carol_balance, "5",
        "only the request_spend payout moved tokens"
    );
    Ok(())
}

/// The Sputnik DAO code that the mainnet treasury `earmark.sputnik-dao.near` runs (code hash
/// `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF`, saved with RPC `view_code` on 10 Nov 2026).
fn sputnik_wasm() -> TestResult<Vec<u8>> {
    let path = format!("{}/tests/res/sputnikdao2.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).map_err(|e| format!("{path}: {e}").into())
}

/// The council's yes vote on proposal `id`, with `tgas` like Trezu (100 Tgas).
async fn vote(
    net: &NetworkConfig,
    council: &Actor,
    dao: &AccountId,
    id: &Value,
    tgas: u64,
) -> TestResult {
    let id: u64 = id.as_str().ok_or("no proposal id")?.parse()?;
    let p = view(net, dao, "get_proposal", json!({ "id": id })).await?;
    let args = json!({ "id": id, "action": "VoteApprove", "proposal": p["kind"] });
    call_gas(
        net,
        council,
        dao,
        "act_proposal",
        args,
        NearToken::from_near(0),
        tgas,
    )
    .await
}

/// R22 end to end with a real Sputnik DAO: the DAO vote sends the money to Earmark, which pays
/// the payee in the same transaction. A payout that fails stays held and is retried. Deleting a
/// proposal after it paid can't free its work for a second payment.
#[tokio::test]
async fn dao_vote_pays_through_earmark() -> TestResult {
    let names = [
        "club", "token", "earmark", "council", "alice", "carol", "dave",
    ];
    let accounts: Vec<GenesisAccount> = names
        .iter()
        .map(|n| GenesisAccount::default_with_name(n.parse().unwrap()))
        .collect();
    let sandbox = Sandbox::start_sandbox_with_config(SandboxConfig {
        additional_accounts: accounts.clone(),
        ..Default::default()
    })
    .await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let actors = accounts.iter().map(actor).collect::<TestResult<Vec<_>>>()?;
    let [club, token, earmark, council, alice, carol, dave] =
        <[Actor; 7]>::try_from(actors).map_err(|_| "seven actors")?;
    let zero = NearToken::from_near(0);

    Contract::deploy(token.id.clone())
        .use_code(wasm("test_token")?)
        .with_init_call(
            "new",
            json!({ "owner_id": council.id, "name": "Test USDC", "symbol": "tUSDC" }),
        )?
        .with_signer(token.signer.clone())
        .send_to(&net)
        .await?
        .into_result()?;
    // Like a Trezu treasury: the council can also delete proposals (`RemoveProposal`).
    let policy = json!({
        "roles": [
            { "name": "all", "kind": "Everyone", "permissions": ["*:AddProposal"], "vote_policy": {} },
            { "name": "council", "kind": { "Group": [council.id] }, "permissions": ["*:*"], "vote_policy": {} },
        ],
        "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
        "proposal_bond": "1000000000000000000000000",
        "proposal_period": "604800000000000",
        "bounty_bond": "1000000000000000000000000",
        "bounty_forgiveness_period": "86400000000000",
    });
    let config = json!({ "name": "club", "purpose": "test", "metadata": "" });
    Contract::deploy(club.id.clone())
        .use_code(sputnik_wasm()?)
        .with_init_call("new", json!({ "config": config, "policy": policy }))?
        .with_signer(club.signer.clone())
        .send_to(&net)
        .await?
        .into_result()?;
    Contract::deploy(earmark.id.clone())
        .use_code(wasm("earmark")?)
        .with_init_call("new", json!({ "dao_id": club.id, "token_ids": [token.id] }))?
        .with_signer(earmark.signer.clone())
        .send_to(&net)
        .await?
        .into_result()?;

    // The DAO creates the budget by vote (proposal 0).
    let rules = json!({ "envelope": {
        "name": "Events", "token_id": token.id,
        "spenders": [{ "account_id": alice.id, "auto_limit": "10", "period_cap": "100" }],
        "approvers": [council.id], "one_approver_limit": "50", "raise_ceiling": "20",
        "payees": [carol.id, dave.id], "period_secs": "2592000", "period_cap": "100",
    }});
    let create = json!({ "proposal": {
        "description": "create budget",
        "kind": { "FunctionCall": { "receiver_id": earmark.id, "actions": [{
            "method_name": "create_envelope",
            "args": serde_json::to_value(near_sdk::json_types::Base64VecU8(rules.to_string().into_bytes()))?,
            "deposit": "100000000000000000000000",
            "gas": "50000000000000",
        }]}},
    }});
    let bond = NearToken::from_near(1);
    call(&net, &council, &club.id, "add_proposal", create, bond).await?;
    vote(&net, &council, &club.id, &json!("0"), 150).await?;

    // The treasury holds 1000; Earmark and carol are registered with the token, dave isn't.
    for account in [&club.id, &earmark.id, &carol.id] {
        let args = json!({ "account_id": account, "registration_only": true });
        let deposit = NearToken::from_millinear(10);
        call(&net, &council, &token.id, "storage_deposit", args, deposit).await?;
    }
    let mint = json!({ "account_id": club.id, "amount": "1000" });
    call(&net, &council, &token.id, "mint", mint, zero).await?;

    // Above the one-approver limit: each becomes a DAO proposal.
    let ask = |id: &str, payee: &AccountId, amount: &str| json!({ "envelope_id": "0", "request_id": id, "payee": payee, "amount": amount, "memo": "", "work_ref": id });
    call(
        &net,
        &alice,
        &earmark.id,
        "request_spend",
        ask("to-carol", &carol.id, "300"),
        zero,
    )
    .await?;
    call(
        &net,
        &alice,
        &earmark.id,
        "request_spend",
        ask("to-dave", &dave.id, "200"),
        zero,
    )
    .await?;
    let request = |id: &str| {
        view(
            &net,
            &earmark.id,
            "get_request",
            json!({ "request_id": id }),
        )
    };
    let balance = |id: &AccountId| {
        view(
            &net,
            &token.id,
            "ft_balance_of",
            json!({ "account_id": id }),
        )
    };

    // The vote pays carol through Earmark in the same transaction, with Trezu's 100 Tgas.
    let to_carol = request("to-carol").await?;
    assert_eq!(status(&to_carol), "escalated", "{to_carol}");
    vote(&net, &council, &club.id, &to_carol["dao_proposal_id"], 100).await?;
    let to_carol = request("to-carol").await?;
    assert_eq!(status(&to_carol), "paid_by_dao", "{to_carol}");
    assert_eq!(balance(&carol.id).await?, "300");
    assert_eq!(balance(&earmark.id).await?, "0");

    // Deleting the proposal after it paid: settle refuses, and the work stays claimed.
    let id: u64 = to_carol["dao_proposal_id"].as_str().unwrap().parse()?;
    let kind = view(&net, &club.id, "get_proposal", json!({ "id": id })).await?["kind"].clone();
    let remove = json!({ "id": id, "action": "RemoveProposal", "proposal": kind });
    call(&net, &council, &club.id, "act_proposal", remove, zero).await?;
    let settle = json!({ "request_id": "to-carol" });
    let err = call_err(&net, &carol, &earmark.id, "settle_escalation", settle).await?;
    assert!(err.contains("not_escalated"), "{err}");
    let again = json!({ "envelope_id": "0", "spender": alice.id, "request_id": "again",
        "payee": carol.id, "amount": "5", "work_ref": "to-carol" });
    let check = view(&net, &earmark.id, "check_spend", again).await?;
    assert_eq!(check["blocked"], "duplicate_work", "{check}");

    // dave isn't registered: the payout fails, Earmark holds the 200, and a retry pays it.
    let to_dave = request("to-dave").await?;
    vote(&net, &council, &club.id, &to_dave["dao_proposal_id"], 100).await?;
    let to_dave = request("to-dave").await?;
    assert_eq!(
        (status(&to_dave), &to_dave["failure"]),
        ("dao_funded", &json!("payout_failed")),
        "{to_dave}"
    );
    assert_eq!(balance(&earmark.id).await?, "200");
    let args = json!({ "account_id": dave.id, "registration_only": true });
    let deposit = NearToken::from_millinear(10);
    call(&net, &dave, &token.id, "storage_deposit", args, deposit).await?;
    let settle = json!({ "request_id": "to-dave" });
    call(&net, &carol, &earmark.id, "settle_escalation", settle, zero).await?;
    assert_eq!(status(&request("to-dave").await?), "paid_by_dao");
    assert_eq!(balance(&dave.id).await?, "200");
    assert_eq!(balance(&earmark.id).await?, "0");
    assert_eq!(balance(&club.id).await?, "500");
    let payee = view(
        &net,
        &earmark.id,
        "get_payee_record",
        json!({ "account_id": carol.id }),
    )
    .await?;
    assert_eq!(payee["paid_total"], "300");
    Ok(())
}
