// The raw RPC answers behind one Verify check, with the exact request, so anyone can repeat it
// with curl against any NEAR node. Read-only, public data.
import { NextResponse } from "next/server";
import { CONTRACT, EXPECTED_DAO, RPC_URL } from "@/lib/config";
import { getConfig, rpcQuery } from "@/lib/near";

export const dynamic = "force-dynamic";

const call = (account: string, method: string, args: object = {}) => ({
  request_type: "call_function",
  finality: "final",
  account_id: account,
  method_name: method,
  args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  args,
});

async function queries(check: string): Promise<object[] | null> {
  switch (check) {
    case "keys":
      return [{ request_type: "view_access_key_list", finality: "final", account_id: CONTRACT }];
    case "code":
      return [
        { request_type: "view_account", finality: "final", account_id: CONTRACT },
        call(CONTRACT, "contract_source_metadata"),
      ];
    case "owner":
      return [call(CONTRACT, "get_config")];
    case "upgrades": {
      const dao = await getConfig()
        .then((c) => c.dao_id)
        .catch(() => EXPECTED_DAO);
      return [call(dao, "get_proposals", { from_index: 0, limit: 100 })];
    }
    case "balances": {
      const tokens = await getConfig()
        .then((c) => c.token_ids)
        .catch(() => []);
      return [
        call(CONTRACT, "list_envelopes"),
        ...tokens.map((t) => call(t, "ft_balance_of", { account_id: CONTRACT })),
      ];
    }
    default:
      return null;
  }
}

/** call_function results are bytes; show them as the JSON the contract returned. */
function decode(result: unknown): unknown {
  const r = result as { result?: number[] };
  if (!Array.isArray(r?.result)) return result;
  try {
    return { ...r, result: JSON.parse(Buffer.from(r.result).toString()) };
  } catch {
    return result;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ check: string }> }) {
  const list = await queries((await params).check);
  if (!list) return NextResponse.json({ error: "unknown_check" }, { status: 404 });
  const answers = await Promise.all(
    list.map(async (q) => {
      const { args, ...params } = q as { args?: object };
      const request = { jsonrpc: "2.0", id: "verify", method: "query", params };
      try {
        const r = await rpcQuery(params);
        return {
          ...(args ? { args } : {}),
          request,
          response: decode(r.value),
          read_at: new Date(r.at).toISOString(),
          ...(r.stale ? { note: "RPC unreachable; this is the last good answer" } : {}),
        };
      } catch (e) {
        return { request, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return NextResponse.json(
    {
      how: `POST each "request" as JSON to a NEAR RPC node, e.g. ${RPC_URL}`,
      answers,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
