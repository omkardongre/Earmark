//! Sandbox tests against a real NEP-141 token: a payout to an account that isn't registered
//! with the token fails, and the budget gets the reservation back.

use std::sync::Arc;

use near_api::types::{AccountId, Data, NearGas, NearToken};
use near_api::{Contract, NetworkConfig, Signer};
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
    Contract(contract.clone())
        .call_function(method, args)
        .transaction()
        .gas(NearGas::from_tgas(150))
        .deposit(deposit)
        .with_signer(who.id.clone(), who.signer.clone())
        .send_to(net)
        .await?
        .into_result()?;
    Ok(())
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

#[tokio::test]
async fn payout_to_unregistered_payee_fails_and_releases_reservation() -> TestResult {
    let accounts: Vec<GenesisAccount> = ["dao", "token", "earmark", "alice", "carol", "dave"]
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
    let [dao, token, earmark, alice, carol, dave] = &actors[..] else {
        unreachable!()
    };

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

    let rules = json!({ "envelope": {
        "name": "Events", "token_id": token.id,
        "spenders": [{ "account_id": alice.id, "auto_limit": "10", "period_cap": "100" }],
        "approvers": [dao.id], "one_approver_limit": "50", "raise_ceiling": "20",
        "payees": [carol.id, dave.id], "period_secs": "2592000", "period_cap": "100",
    }});
    call(
        &net,
        dao,
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
            dao,
            &token.id,
            "storage_deposit",
            args,
            NearToken::from_millinear(10),
        )
        .await?;
    }
    call(
        &net,
        dao,
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
        dao,
        &token.id,
        "ft_transfer_call",
        fund,
        NearToken::from_yoctonear(1),
    )
    .await?;

    let spend = |id: &str, payee: &AccountId| json!({ "envelope_id": "0", "request_id": id, "payee": payee, "amount": "5", "memo": "", "work_ref": id });
    call(
        &net,
        alice,
        &earmark.id,
        "request_spend",
        spend("to-dave", &dave.id),
        NearToken::from_near(0),
    )
    .await?;
    call(
        &net,
        alice,
        &earmark.id,
        "request_spend",
        spend("to-carol", &carol.id),
        NearToken::from_near(0),
    )
    .await?;

    let status = |r: Value| r["status"].as_str().unwrap_or_default().to_owned();
    let dave_request = view(
        &net,
        &earmark.id,
        "get_request",
        json!({ "request_id": "to-dave" }),
    )
    .await?;
    assert_eq!(status(dave_request.clone()), "failed", "{dave_request}");
    let carol_request = view(
        &net,
        &earmark.id,
        "get_request",
        json!({ "request_id": "to-carol" }),
    )
    .await?;
    assert_eq!(status(carol_request.clone()), "paid", "{carol_request}");

    let envelope = view(
        &net,
        &earmark.id,
        "get_envelope",
        json!({ "envelope_id": "0" }),
    )
    .await?;
    assert_eq!(envelope["balance"], "95");
    assert_eq!(envelope["available"], "95");
    assert_eq!(envelope["in_flight"], "0");
    assert_eq!(envelope["period_spent"], "5");
    let carol_balance = view(
        &net,
        &token.id,
        "ft_balance_of",
        json!({ "account_id": carol.id }),
    )
    .await?;
    assert_eq!(carol_balance, "5");
    Ok(())
}
