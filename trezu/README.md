# Earmark forms for Trezu

Six Trezu custom request templates, so a council runs Earmark from Trezu, where it already votes:

| Form | Calls | What happens |
|---|---|---|
| [Create a budget](earmark-create-budget.json) | `create_envelope` | A USDC budget with one lead, one approver and one payee |
| [Fund a budget](earmark-fund-budget.json) | USDC `ft_transfer_call` | Moves USDC from the treasury into the budget |
| [Change a lead's limit](earmark-set-lead-limit.json) | `update_envelope` | Lowering applies at once; raising waits 1 day and any approver can cancel |
| [Add a payee](earmark-add-payee.json) | `approve_payee` | Payable after 1 day; any approver can cancel before then |
| [Pause a budget](earmark-pause-budget.json) | `pause` | Stops every payment at once |
| [Close a budget](earmark-close-budget.json) | `close_envelope` | Cancels waiting payments, returns what's left to the treasury |

They are written for the mainnet install: contract `budgets.omkar5.near`, native USDC (`17208628…33a1`). For another install, change `receiver_id` (and `token_id` in "Create a budget").

## Add them in Trezu

1. Open `https://trezu.app/<your-dao>/custom-templates/create`. Creating templates needs the DAO's policy permission.
2. Choose **Code** and paste one file's JSON. Save. Repeat for each file.
3. Members fill a form under **Custom templates**. Each filing is a normal DAO proposal that goes through the DAO's usual vote; a form grants no extra rights.

Amounts are in USDC's smallest unit (1 USDC = `1000000`), because Trezu forms take whole numbers only.

## Checked in CI

`make trezu-check` validates every file with Trezu's own manifest validator (fetched from `NEAR-DevHub/trezu` at a pinned commit), then fills each form with sample values and checks that the call matches the Earmark method's exact arguments, the right receiver, and at most 50 Tgas (Trezu votes with 75 Tgas).
