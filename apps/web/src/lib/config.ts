// Public deployment settings. Defaults point at the testnet demo; override with NEXT_PUBLIC_* env.
// `||` (not `??`): the Docker build passes "" for a setting it doesn't override.
export type Network = "testnet" | "mainnet";

export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
export const CONTRACT = process.env.NEXT_PUBLIC_CONTRACT || "budgets.earmark.testnet";

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ||
  (NETWORK === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com");

/**
 * RPC nodes tried in order when a read fails (comma-separated in NEXT_PUBLIC_RPC_FALLBACK_URLS).
 * `RPC_URL` always goes first; duplicates are dropped.
 */
export const RPC_URLS = [
  ...new Set(
    [
      RPC_URL,
      ...(
        process.env.NEXT_PUBLIC_RPC_FALLBACK_URLS ||
        (NETWORK === "mainnet"
          ? "https://rpc.mainnet.fastnear.com,https://rpc.mainnet.near.org"
          : "https://rpc.testnet.fastnear.com,https://rpc.testnet.near.org")
      ).split(","),
    ]
      .map((u) => u.trim())
      .filter(Boolean),
  ),
];

/** One RPC or tx API attempt gives up after this long and the next one is tried. */
export const READ_TIMEOUT_MS = 8_000;

/** FastNEAR transactions API: used only to find the transaction behind each event. */
export const TX_API =
  NETWORK === "mainnet" ? "https://tx.main.fastnear.com" : "https://tx.test.fastnear.com";

export const EXPLORER =
  NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

export const txUrl = (hash: string) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id: string) => `${EXPLORER}/address/${id}`;

/** Where a DAO proposal opens. Trezu on mainnet; the explorer on testnet (Trezu is mainnet only). */
export function proposalUrl(dao: string, id: string | number): string {
  return NETWORK === "mainnet" ? `https://trezu.app/${dao}/requests?id=${id}` : accountUrl(dao);
}

/** The testnet app hosts "Try it" (its sandbox keys are testnet only). */
export const TESTNET_APP = "https://earmark-878141445235.us-central1.run.app";
/** "Try it" link: on this app on testnet, on the testnet app from mainnet. */
export const TRY_URL = NETWORK === "mainnet" ? `${TESTNET_APP}/try` : "/try";

// What the Verify page expects to find on chain. The web image doesn't ship fixtures/, so these
// mirror fixtures/testnet-demo.json (`dao`, `code_hash`); update them when a DAO upgrade lands.
export const EXPECTED_DAO = process.env.NEXT_PUBLIC_DAO || "community-news.sputnikv2.testnet";
export const EXPECTED_CODE_HASH =
  process.env.NEXT_PUBLIC_CODE_HASH || "6H2m7rLWiqkwEdr7DCTN2h5aP4JEKFJkVG4LRawnBhRx";
export const SOURCE_REPO = "https://github.com/omkardongre/Earmark";
